# No Direct useEffect

Never call `useEffect` directly. For the rare case of syncing with an external system on mount, use `useMountEffect()`.

```tsx
export function useMountEffect(effect: () => void | (() => void)) {
  /* eslint-disable react-hooks/exhaustive-deps, no-restricted-syntax */
  useEffect(effect, []);
}
```

The only place `useEffect` may appear directly is inside reusable custom hooks (like `useMountEffect` itself, or a `useData` hook when no fetching library is available). Components must never import or call `useEffect`.

## The 6 Rules

### Rule 1: Derive state, do not sync it

If you can calculate it from existing state/props, compute it inline.

```tsx
// BAD: two render cycles
const [filteredProducts, setFilteredProducts] = useState([]);
useEffect(() => {
  setFilteredProducts(products.filter((p) => p.inStock));
}, [products]);

// GOOD: one render
const filteredProducts = products.filter((p) => p.inStock);
```

For expensive calculations, use `useMemo`:

```tsx
const visibleTodos = useMemo(
  () => getFilteredTodos(todos, filter),
  [todos, filter]
);
```

**Smell test:** You're about to write `useEffect(() => setX(f(y)), [y])` or state that only mirrors other state/props.

### Rule 2: Use data-fetching libraries

Effect-based fetching creates race conditions and reinvents caching.

```tsx
// BAD: race condition
useEffect(() => {
  fetchProduct(productId).then(setProduct);
}, [productId]);

// GOOD: library handles cancellation/caching/staleness
const { data: product } = useQuery(
  ['product', productId],
  () => fetchProduct(productId)
);
```

In React 19+, use the `use()` hook with `<Suspense>` to unwrap promises without `useEffect` or `useState`:

```tsx
// GOOD: use() + Suspense (React 19+)
function UserProfile({ userPromise }: { userPromise: Promise<User> }) {
  const user = use(userPromise);
  return <h1>{user.name}</h1>;
}
```

**Smell test:** Your effect does `fetch()` then `setState()`, or you're reimplementing caching/retries/cancellation.

### Rule 3: Event handlers, not effects

If a user action triggers it, do the work in the handler. Procedural logic (validate → transform → submit) belongs in handlers. Reconstructing procedural flow through ref+effect chains is a sign the logic was event-driven from the start.

```tsx
// BAD: flag-relay through effect
const [liked, setLiked] = useState(false);
useEffect(() => {
  if (liked) { postLike(); setLiked(false); }
}, [liked]);

// GOOD: direct
<button onClick={() => postLike()}>Like</button>
```

For shared logic between handlers, extract a function — not an effect:

```tsx
function buyProduct() {
  addToCart(product);
  showNotification(`Added ${product.name}`);
}
```

**Smell test:** State used as a flag so an effect can do the real action, or "set flag -> effect runs -> reset flag" mechanics.

### Rule 4: useMountEffect for one-time external sync

Only for true mount-time external system setup: DOM integration, third-party widgets, browser API subscriptions.

```tsx
// BAD: guard inside effect
useEffect(() => {
  if (!isLoading) playVideo();
}, [isLoading]);

// GOOD: conditional mounting
function VideoPlayerWrapper({ isLoading }) {
  if (isLoading) return <LoadingScreen />;
  return <VideoPlayer />;
}
function VideoPlayer() {
  useMountEffect(() => playVideo());
}
```

**Smell test:** Behavior is naturally "setup on mount, cleanup on unmount" with an external system.

### Rule 5: Reset with key, not dependency choreography

If you need "start fresh when ID changes," use React's remount semantics.

```tsx
// BAD: effect resets on ID change
useEffect(() => { loadVideo(videoId); }, [videoId]);

// GOOD: key forces clean remount
<VideoPlayer key={videoId} videoId={videoId} />

function VideoPlayer({ videoId }) {
  useMountEffect(() => { loadVideo(videoId); });
}
```

This also applies to resetting form state, clearing selections, etc. Use `key` on the component instead of an effect that sets state to initial values.

**Smell test:** Effect's only job is to reset local state when an ID/prop changes.

### Rule 6: Never patch a broken effect with a ref

If you need a `useRef` to stop an effect from double-firing, looping, or accessing stale state, the effect itself is the problem. Eliminate the root effect — don't bandage it with a ref.

```tsx
// BAD: ref guard hides the real problem
const hasRun = useRef(false);
useEffect(() => {
  if (hasRun.current) return;
  hasRun.current = true;
  showWelcomeToast(userId);
}, [userId]);

// GOOD: useMountEffect for true one-time setup
useMountEffect(() => {
  showWelcomeToast(userId);
});
```

```tsx
// BAD: ref to capture latest callback, dodging the dependency array
const onMessageRef = useRef(onMessage);
onMessageRef.current = onMessage;
useEffect(() => {
  const conn = createConnection(roomId);
  conn.on('message', (msg) => onMessageRef.current(msg));
  return () => conn.disconnect();
}, [roomId]);

// GOOD: useEffectEvent (experimental) captures latest values automatically
const onMsg = useEffectEvent((msg) => {
  onMessage(msg);
});
useEffect(() => {
  const conn = createConnection(roomId);
  conn.on('message', onMsg);
  return () => conn.disconnect();
}, [roomId]);
```

The React docs explicitly warn: *"The right question isn't 'how to run an Effect once', but 'how to fix my Effect so that it works after remounting'."*

**Smell test:** You're adding `hasRun.current`, `isMounted.current`, or a ref whose sole purpose is controlling when/if an effect runs. Or you're storing a callback in a ref to avoid listing it as a dependency.

## Additional Patterns

### Notifying parents about state changes

Do not use an effect to call `onChange` — update both in the event handler, or lift state up:

```tsx
// BAD
useEffect(() => { onChange(isOn); }, [isOn, onChange]);

// GOOD: update both during the event
function updateToggle(nextIsOn) {
  setIsOn(nextIsOn);
  onChange(nextIsOn);
}
```

### useEffectEvent for latest values (experimental)

When an effect needs to read the latest value of a prop/state without re-running when it changes, use `useEffectEvent` instead of a ref workaround:

```tsx
// BAD: ref to read latest theme without adding it as dependency
const themeRef = useRef(theme);
themeRef.current = theme;
useEffect(() => {
  logVisit(url, themeRef.current);
}, [url]);

// GOOD: useEffectEvent reads latest values automatically
const onVisit = useEffectEvent(() => {
  logVisit(url, theme);
});
useEffect(() => {
  onVisit();
}, [url]);
```

Until `useEffectEvent` is stable, prefer moving logic to event handlers or `useMountEffect`. If neither fits, isolate the ref workaround in a custom hook — never in a component.

### Callback refs for DOM side effects

For DOM measurement or setup, a callback ref is more reliable than `useRef` + `useMountEffect` — it fires exactly when the node attaches or detaches:

```tsx
// BAD: ref.current may be null on first render
const ref = useRef(null);
useMountEffect(() => {
  setHeight(ref.current.getBoundingClientRect().height);
});
return <div ref={ref}>Content</div>;

// GOOD: callback ref fires when node is attached
const measuredRef = useCallback((node: HTMLDivElement | null) => {
  if (node !== null) {
    setHeight(node.getBoundingClientRect().height);
  }
}, []);
return <div ref={measuredRef}>Content</div>;
```

In React 19+, callback refs support cleanup return values. For earlier versions, store cleanup logic in a ref inside a custom hook.

### Subscribing to external stores

Use `useSyncExternalStore` instead of manual subscription effects:

```tsx
const isOnline = useSyncExternalStore(
  subscribe,
  () => navigator.onLine,
  () => true
);
```

### App initialization

Run once at module level, not in an effect:

```tsx
if (typeof window !== 'undefined') {
  checkAuthToken();
  loadDataFromLocalStorage();
}
```

### Chains of computations

Never chain effects that trigger each other. Derive values inline and batch state updates in the event handler:

```tsx
// BAD: 3 effects chaining state -> 3 extra renders
useEffect(() => { if (card?.gold) setGoldCardCount(c => c + 1); }, [card]);
useEffect(() => { if (goldCardCount > 3) { setRound(r => r + 1); setGoldCardCount(0); } }, [goldCardCount]);
useEffect(() => { if (round > 5) setIsGameOver(true); }, [round]);

// GOOD: derive + handle in event
const isGameOver = round > 5;

function handlePlaceCard(nextCard) {
  setCard(nextCard);
  if (nextCard.gold) {
    if (goldCardCount < 3) setGoldCardCount(goldCardCount + 1);
    else { setGoldCardCount(0); setRound(round + 1); }
  }
}
```

## Decision Checklist

Before writing any effect, answer these questions:

1. **Can I compute it during render?** -> Derive it inline or `useMemo`
2. **Is it triggered by a user action?** -> Event handler
3. **Am I fetching data?** -> Data-fetching library (React Query, SWR, etc.) or `use()` + Suspense in React 19+
4. **Am I subscribing to an external store?** -> `useSyncExternalStore`
5. **Do I need to reset state when a prop changes?** -> `key` prop
6. **Is it true mount-time external system sync?** -> `useMountEffect`
7. **Am I using refs to control when/if an effect runs?** -> Remove the refs; move logic to an event handler, derive it, or use `useEffectEvent`
8. **Do I need a DOM side effect when a node mounts?** -> Callback ref

If none of the above apply and you still think you need `useEffect`, see [the detailed patterns below](no-use-effect.md#detailed-patterns--examples).

## Failure Modes

- **useMountEffect failures** are binary and loud: it ran once, or not at all
- **Direct useEffect failures** degrade gradually as flaky behavior, perf issues, or loops before a hard crash

Choose the bug that's easy to find.

# Detailed Patterns & Examples

Extended examples for each rule when the SKILL.md summary isn't enough.

## Table of Contents

- [Derived State](#derived-state)
- [Expensive Calculations with useMemo](#expensive-calculations-with-usememo)
- [Data Fetching Race Conditions](#data-fetching-race-conditions)
- [Event Handler Extraction](#event-handler-extraction)
- [Conditional Mounting](#conditional-mounting)
- [Key-Based Reset](#key-based-reset)
- [Adjusting State on Prop Change](#adjusting-state-on-prop-change)
- [Effect Chains](#effect-chains)
- [Parent Notification](#parent-notification)
- [External Store Subscription](#external-store-subscription)
- [App Initialization](#app-initialization)
- [Effect-Ref Debt Spiral](#effect-ref-debt-spiral)
- [useEffectEvent](#useeffectevent)
- [Callback Refs](#callback-refs)

---

## Derived State

### Chained derived values

```tsx
// BAD: effect chain for tax/total
function Cart({ subtotal }) {
  const [tax, setTax] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => { setTax(subtotal * 0.1); }, [subtotal]);
  useEffect(() => { setTotal(subtotal + tax); }, [subtotal, tax]);
}

// GOOD: inline computation
function Cart({ subtotal }) {
  const tax = subtotal * 0.1;
  const total = subtotal + tax;
}
```

### fullName from firstName + lastName

```tsx
// BAD
const [fullName, setFullName] = useState('');
useEffect(() => {
  setFullName(firstName + ' ' + lastName);
}, [firstName, lastName]);

// GOOD
const fullName = firstName + ' ' + lastName;
```

---

## Expensive Calculations with useMemo

```tsx
// BAD
const [visibleTodos, setVisibleTodos] = useState([]);
useEffect(() => {
  setVisibleTodos(getFilteredTodos(todos, filter));
}, [todos, filter]);

// GOOD
const visibleTodos = useMemo(
  () => getFilteredTodos(todos, filter),
  [todos, filter]
);
```

**When is a calculation expensive?** Measure with `console.time`. Generally only worth memoizing if >1ms on throttled CPU.

---

## Data Fetching Race Conditions

### The problem with bare fetch in effects

User types "hello" fast. Requests fire for "h", "he", "hel", "hell", "hello". Response for "hell" may arrive after "hello", showing wrong results.

### If you must use an effect for fetching (no library available)

Encapsulate in a custom hook — never use `useEffect` directly in a component. Always add cleanup:

### Extract into a custom hook

```tsx
function useData(url) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let ignore = false;
    fetch(url)
      .then(r => r.json())
      .then(json => { if (!ignore) setData(json); });
    return () => { ignore = true; };
  }, [url]);
  return data;
}
```

**Note:** `useEffect` inside a custom hook like `useData` is the accepted escape hatch — the rule bans direct `useEffect` in components, not in reusable hooks that encapsulate side effects behind a clean interface.

### Best: use a data-fetching library

React Query, SWR, TanStack Query, or framework-provided fetching. These handle caching, deduplication, cancellation, retries, background refetching, stale-while-revalidate, and SSR hydration.

---

## Event Handler Extraction

### Shared logic between multiple handlers

```tsx
// BAD: effect watches product.isInCart
useEffect(() => {
  if (product.isInCart) {
    showNotification(`Added ${product.name}!`);
  }
}, [product]);

// GOOD: shared function called from handlers
function buyProduct() {
  addToCart(product);
  showNotification(`Added ${product.name}!`);
}

function handleBuyClick() { buyProduct(); }
function handleCheckoutClick() { buyProduct(); navigateTo('/checkout'); }
```

### Form submission

```tsx
// BAD: effect watches jsonToSubmit
const [jsonToSubmit, setJsonToSubmit] = useState(null);
useEffect(() => {
  if (jsonToSubmit !== null) post('/api/register', jsonToSubmit);
}, [jsonToSubmit]);

// GOOD: submit in the handler
function handleSubmit(e) {
  e.preventDefault();
  post('/api/register', { firstName, lastName });
}
```

### Analytics vs. user actions

Analytics that fire "because the component was displayed" are valid for `useMountEffect`. Form submission that fires "because the user clicked submit" belongs in the handler.

---

## Conditional Mounting

Instead of guarding inside an effect, control mounting in the parent:

```tsx
// BAD
function VideoPlayer({ isLoading }) {
  useEffect(() => {
    if (!isLoading) playVideo();
  }, [isLoading]);
}

// GOOD: parent controls when to mount
function VideoPlayerWrapper({ isLoading }) {
  if (isLoading) return <LoadingScreen />;
  return <VideoPlayer />;
}

function VideoPlayer() {
  useMountEffect(() => playVideo());
}
```

### Persistent shell + conditional instance

When you need a persistent container but conditional behavior:

```tsx
function VideoPlayerContainer({ isLoading }) {
  return (
    <>
      <VideoPlayerShell isLoading={isLoading} />
      {!isLoading && <VideoPlayerInstance />}
    </>
  );
}

function VideoPlayerInstance() {
  useMountEffect(() => playVideo());
}
```

---

## Key-Based Reset

### Resetting all state when entity changes

```tsx
// BAD
function ProfilePage({ userId }) {
  const [comment, setComment] = useState('');
  useEffect(() => { setComment(''); }, [userId]);
}

// GOOD: key forces full reset
function ProfilePage({ userId }) {
  return <Profile userId={userId} key={userId} />;
}

function Profile({ userId }) {
  const [comment, setComment] = useState('');
  // Fresh state on each userId change
}
```

### Resetting form state

```tsx
// BAD: effect clears form fields
useEffect(() => {
  setName('');
  setEmail('');
  setNotes('');
}, [contactId]);

// GOOD
<EditForm key={contactId} contact={contact} />
```

---

## Adjusting State on Prop Change

When you only need to adjust some state (not reset everything):

### Best: derive it during render

```tsx
function List({ items }) {
  const [selectedId, setSelectedId] = useState(null);
  // If selected item no longer exists, selection clears automatically
  const selection = items.find(item => item.id === selectedId) ?? null;
}
```

### Acceptable: adjust during render with previous props tracking

```tsx
function List({ items }) {
  const [isReverse, setIsReverse] = useState(false);
  const [selection, setSelection] = useState(null);
  const [prevItems, setPrevItems] = useState(items);

  if (items !== prevItems) {
    setPrevItems(items);
    setSelection(null);
  }
}
```

---

## Effect Chains

### The game card example

```tsx
// BAD: 4 effects chaining state updates = 4 extra renders
useEffect(() => { if (card?.gold) setGoldCardCount(c => c + 1); }, [card]);
useEffect(() => { if (goldCardCount > 3) { setRound(r => r + 1); setGoldCardCount(0); } }, [goldCardCount]);
useEffect(() => { if (round > 5) setIsGameOver(true); }, [round]);
useEffect(() => { if (isGameOver) alert('Good game!'); }, [isGameOver]);

// GOOD: all logic in the event handler, derived state inline
const isGameOver = round > 5;

function handlePlaceCard(nextCard) {
  if (isGameOver) throw Error('Game already ended.');
  setCard(nextCard);
  if (nextCard.gold) {
    if (goldCardCount < 3) {
      setGoldCardCount(goldCardCount + 1);
    } else {
      setGoldCardCount(0);
      setRound(round + 1);
      if (round === 5) alert('Good game!');
    }
  }
}
```

---

## Parent Notification

### Option A: update both in same event

```tsx
function Toggle({ onChange }) {
  const [isOn, setIsOn] = useState(false);

  function updateToggle(nextIsOn) {
    setIsOn(nextIsOn);
    onChange(nextIsOn);
  }

  return <button onClick={() => updateToggle(!isOn)}>Toggle</button>;
}
```

### Option B: fully controlled component (preferred)

```tsx
function Toggle({ isOn, onChange }) {
  return <button onClick={() => onChange(!isOn)}>Toggle</button>;
}
```

### Passing data to parent

```tsx
// BAD: child fetches, then notifies parent via effect
useEffect(() => { if (data) onFetched(data); }, [onFetched, data]);

// GOOD: parent owns the fetch, passes data down
function Parent() {
  const data = useSomeAPI();
  return <Child data={data} />;
}
```

---

## External Store Subscription

```tsx
// BAD: manual subscription
useEffect(() => {
  const handler = () => setIsOnline(navigator.onLine);
  window.addEventListener('online', handler);
  window.addEventListener('offline', handler);
  return () => {
    window.removeEventListener('online', handler);
    window.removeEventListener('offline', handler);
  };
}, []);

// GOOD: useSyncExternalStore
function subscribe(callback) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function useOnlineStatus() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true // SSR fallback
  );
}
```

---

## App Initialization

```tsx
// BAD: runs twice in dev, can invalidate tokens
useEffect(() => {
  loadDataFromLocalStorage();
  checkAuthToken();
}, []);

// GOOD option 1: module-level
if (typeof window !== 'undefined') {
  checkAuthToken();
  loadDataFromLocalStorage();
}

// GOOD option 2: guard variable with useMountEffect
let didInit = false;
function App() {
  useMountEffect(() => {
    if (!didInit) {
      didInit = true;
      loadDataFromLocalStorage();
      checkAuthToken();
    }
  });
}
```

---

## Effect-Ref Debt Spiral

When a `useEffect` causes problems (double-firing, stale closures, loops), developers often "patch" it with a `useRef` instead of fixing the root cause. This creates a brittle hybrid where two state systems compete: one React tracks (useState) and one it doesn't (useRef). The fix is always to eliminate the effect, not to bandage it.

### `hasRun` guard to prevent double-fire

```tsx
// BAD: ref guard hides the real problem — Strict Mode double-fire exists
// to surface missing cleanup, not to be silenced
function UserGreeting({ userId }) {
  const hasRun = useRef(false);
  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    showWelcomeToast(userId);
  }, [userId]);
}

// GOOD: if it's truly one-time mount setup
function UserGreeting({ userId }) {
  useMountEffect(() => {
    showWelcomeToast(userId);
  });
}

// BETTER: if the toast is a response to navigation, it belongs in the
// navigation handler, not in the component lifecycle at all
```

### `isMounted` ref to avoid set-state-after-unmount

```tsx
// BAD: isMounted ref masks a missing cancellation
function Profile({ userId }) {
  const [user, setUser] = useState(null);
  const isMounted = useRef(true);
  useEffect(() => {
    fetchUser(userId).then(data => {
      if (isMounted.current) setUser(data);
    });
    return () => { isMounted.current = false; };
  }, [userId]);
}

// GOOD: data-fetching library handles cancellation
function Profile({ userId }) {
  const { data: user } = useQuery(['user', userId], () => fetchUser(userId));
}

// GOOD: if no library, use a cleanup boolean in a custom hook (not a ref)
function useData(url) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let ignore = false;
    fetch(url)
      .then(r => r.json())
      .then(json => { if (!ignore) setData(json); });
    return () => { ignore = true; };
  }, [url]);
  return data;
}
```

**Why `ignore` is not the same as `isMounted.current`:** The `ignore` boolean is scoped to a single effect execution and cleaned up by that same execution's cleanup function. It doesn't persist across renders or leak into other parts of the component. A `useRef` persists across the entire component lifetime and creates a second, invisible state channel.

### Ref to capture latest callback (dodging the dependency array)

```tsx
// BAD: ref stores latest callback to avoid listing it as a dependency
function ChatRoom({ roomId, onMessage }) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const conn = createConnection(roomId);
    conn.on('message', (msg) => onMessageRef.current(msg));
    return () => conn.disconnect();
  }, [roomId]); // onMessage is missing — linter would complain without the ref trick
}

// GOOD: useEffectEvent (see section below)
// GOOD: if no useEffectEvent, isolate in a custom hook — never in a component
```

---

## useEffectEvent

`useEffectEvent` is an experimental React API that solves the "latest value in an effect" problem. It wraps non-reactive logic so that it always reads the latest values without being a dependency of the effect.

### Reading latest callback without refs

```tsx
// BAD: ref workaround for latest callback
function ChatRoom({ roomId, onMessage }) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  useEffect(() => {
    const conn = createConnection(roomId);
    conn.on('message', (msg) => onMessageRef.current(msg));
    return () => conn.disconnect();
  }, [roomId]);
}

// GOOD: useEffectEvent captures latest values automatically
function ChatRoom({ roomId, onMessage }) {
  const onMsg = useEffectEvent((msg) => {
    onMessage(msg);
  });

  useEffect(() => {
    const conn = createConnection(roomId);
    conn.on('message', onMsg);
    return () => conn.disconnect();
  }, [roomId]); // onMsg is stable, no need to list it
}
```

### Logging with latest state

```tsx
// BAD: ref to read latest theme in effect
function Page({ url }) {
  const [theme, setTheme] = useState('light');
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    logVisit(url, themeRef.current);
  }, [url]); // eslint-disable-next-line — lying to the linter

  // ...
}

// GOOD: useEffectEvent
function Page({ url }) {
  const [theme, setTheme] = useState('light');
  const onVisit = useEffectEvent(() => {
    logVisit(url, theme); // always reads latest theme
  });
  useEffect(() => {
    onVisit();
  }, [url]);

  // ...
}
```

**Until `useEffectEvent` is stable:** prefer moving logic to event handlers or `useMountEffect`. If neither fits, isolate the ref workaround in a custom hook — never directly in a component.

---

## Callback Refs

When you need a side effect tied to a DOM node's presence, a callback ref is more reliable than `useRef` + `useMountEffect`. It fires exactly when the node attaches or detaches, with no timing issues.

### Measuring a DOM node

```tsx
// BAD: ref.current may be null on first render if the node is conditionally rendered
function MeasuredBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useMountEffect(() => {
    setHeight(ref.current!.getBoundingClientRect().height);
  });
  return <div ref={ref}>Content</div>;
}

// GOOD: callback ref fires when node is attached
function MeasuredBox() {
  const [height, setHeight] = useState(0);
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) {
      setHeight(node.getBoundingClientRect().height);
    }
  }, []);
  return <div ref={measuredRef}>Content</div>;
}
```

### Focus on mount

```tsx
// BAD
const inputRef = useRef<HTMLInputElement>(null);
useMountEffect(() => { inputRef.current?.focus(); });
return <input ref={inputRef} />;

// GOOD: callback ref
<input ref={(node) => node?.focus()} />
```

### Third-party library initialization (React 19+)

```tsx
// BAD: ref + useMountEffect
const containerRef = useRef<HTMLDivElement>(null);
useMountEffect(() => {
  const chart = new Chart(containerRef.current!, config);
  return () => chart.destroy();
});
return <div ref={containerRef} />;

// GOOD: callback ref with cleanup (React 19+ supports return values)
const chartRef = useCallback((node: HTMLDivElement | null) => {
  if (node === null) return;
  const chart = new Chart(node, config);
  return () => chart.destroy(); // cleanup when node detaches
}, [config]);
return <div ref={chartRef} />;
```

**Note:** React 19 supports cleanup return values from callback refs. For earlier versions, store the cleanup in a ref inside a custom hook.

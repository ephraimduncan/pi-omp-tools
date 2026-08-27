---
name: writing-better-tests
description: "Write tests that catch real breaks and skip tests that catch nothing. Use when writing or changing tests, adding mocks, fixing failing tests, or tempted to add test-only methods to production code. Also use to decide whether code deserves a test at all — not everything does."
---

# Writing Better Tests

A test exists to catch a specific break. Tests must verify real behavior, not mock behavior — mocks are a means to isolate, not the thing being tested.

Two principles govern everything here:

```
1. Every test names the break it catches
2. Every test exercises the real thing
```

## The Iron Laws

```
1. NEVER test mock behavior
2. NEVER add test-only methods to production classes
3. NEVER mock without understanding dependencies
```

Strict TDD produces all of this naturally: a test written first and watched failing against real code has already proven it can fail, and only earns a mock when the real dependency proves slow or external.

## Not Everything Earns a Test

Ship the tests the behavior needs and only those. Trivial code and human prose earn none; a test written to satisfy process costs maintenance forever. Constructors, getters, constants, and trivial forwarding earn tests only when they validate, normalize, default, derive, enforce, or cause side effects — otherwise assert the first consumer-visible result that depends on them.

## Principle 1: Name the Break

Before writing the test body, answer: **what production change should make this test fail — and is that change a bug or a decision?** A test earns its place by catching a wrong branch, missing side effect, wrong argument, boundary case, or broken contract.

**Derive expectations independently.** Use literals and hand-checked fixtures; table-driven tests with literal `want` values are the preferred shape. An expectation computed by the code under test — or its helpers — passes no matter what that code does:

```typescript
// ❌ Mirror assertion: the same builder computes both sides — always true
const expected = buildSearchQuery({ tag: 'urgent' });
expect(buildSearchQuery({ tag: 'urgent' })).toBe(expected);

// ✅ Hand-derived literal
expect(buildSearchQuery({ tag: 'urgent' })).toBe('tag:"urgent"');
```

**No change detectors.** If only intentional decisions can fail a test — a constant's value, exact message wording, private structure — it fires on redesign and sleeps through bugs. Test the behavior that depends on the decision: not `expect(MAX_RETRIES).toBe(5)` but "a failing call is retried 5 times and the 6th attempt never happens."

**Behavior, not text.** Asserting that a script, skill, or config contains an exact line proves only that the source is the source. Run scripts against controlled inputs and assert outputs, side effects, or exit codes. Prose for humans earns no test at all.

**Your code, not the framework.** Test the contract your code makes at its boundaries — the route you register, the query you emit, the payload you produce. Upstream mechanics are their maintainers' tests to write (the classic: asserting your router invokes a registered handler — that is the framework's test, not yours). When upstream behavior genuinely surprised you, write one narrow characterization test naming the assumption.

### Gate: before writing the test body

```
Name the production change that would make this test fail.

  Cannot name one            → redesign around an observable behavior
  "The source text changed"  → run the artifact and assert its effects
  Only intentional decisions → change detector; test the behavior
                               that depends on the decision

Confirm the expected value is derived without the code under test.
  IF it reuses the code's logic or helpers:
    Replace it with a literal or hand-checked fixture
```

## Principle 2: Exercise the Real Thing

### The mock earns no assertions

A mock assertion passes when the mock is present and fails when it is absent — it says nothing about the component. You're verifying the mock works, not that the component works.

```typescript
// ❌ BAD: Testing that the mock exists
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});

// ✅ GOOD: Test real component or don't mock it
test('renders sidebar', () => {
  render(<Page />);  // Don't mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// OR if sidebar must be mocked for isolation:
// Don't assert on the mock - test Page's behavior with sidebar present
```

The correction to internalize: *"Are we testing the behavior of a mock?"*

```
BEFORE asserting on any mock element:
  Ask: "Am I testing real component behavior or just mock existence?"

  IF testing mock existence:
    STOP - Delete the assertion or unmock the component

  Test real behavior instead
```

### Never mock without understanding

Learn every side effect of the real method before replacing it; mock the slow or external operation and keep what the test depends on real. Over-mocking to "be safe" breaks actual behavior — the test passes for the wrong reason or fails mysteriously.

```typescript
// ❌ BAD: Mock breaks test logic — it swallows the config write
// that duplicate detection depends on
vi.mock('ToolCatalog', () => ({
  discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
}));

await addServer(config);
await addServer(config);  // Should throw - but won't!

// ✅ GOOD: Mock at correct level — just the slow server startup;
// the config write stays real
vi.mock('MCPServerManager');

await addServer(config);  // Config written
await addServer(config);  // Duplicate detected ✓
```

```
BEFORE mocking any method:
  STOP - Don't mock yet

  1. Ask: "What side effects does the real method have?"
  2. Ask: "Does this test depend on any of those side effects?"
  3. Ask: "Do I fully understand what this test needs?"

  IF depends on side effects:
    Mock at lower level (the actual slow/external operation)
    OR use test doubles that preserve necessary behavior
    NOT the high-level method the test depends on

  IF unsure what test depends on:
    Run test with real implementation FIRST
    Observe what actually needs to happen
    THEN add minimal mocking at the right level

  Red flags:
    - "I'll mock this to be safe"
    - "This might be slow, better mock it"
    - Mocking without understanding the dependency chain
```

### Mirror real data completely

Partial mocks hide structural assumptions — you only mocked fields you know about. Downstream code may depend on fields you didn't include, so tests pass while integration fails. Mock the COMPLETE data structure as it exists in reality, not just fields your immediate test uses.

```typescript
// ❌ BAD: Partial mock - only fields you think you need
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // Missing: metadata that downstream code uses
  // Later: breaks when code accesses response.metadata.requestId
};

// ✅ GOOD: Mirror real API completeness
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // All fields real API returns
};
```

```
BEFORE creating mock responses:
  Check: "What fields does the real API response contain?"

  1. Examine actual API response from docs/examples
  2. Include ALL fields system might consume downstream
  3. Verify mock matches real response schema completely

  If uncertain: Include all documented fields
```

### Make doubles specific

When arguments, call counts, or ordering are part of the contract, assert them — a fake that accepts anything verifies nothing. Give each branch (success, error, malformed) its own fixture or spy, so the wrong branch cannot satisfy the expectation.

### Production classes carry production methods only

Cleanup that only tests need lives in test utilities, never on the production class. Test-only methods pollute production code, are dangerous if accidentally called in production, and confuse object lifecycle with entity lifecycle.

```typescript
// ❌ BAD: destroy() only used in tests — looks like production API!
class Session {
  async destroy() {
    await this._workspaceManager?.destroyWorkspace(this.id);
  }
}
afterEach(() => session.destroy());

// ✅ GOOD: Test utilities handle test cleanup
// Session has no destroy() - it's stateless in production
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}
afterEach(() => cleanupSession(session));
```

```
BEFORE adding any method to production class:
  Ask: "Is this only used by tests?"
  IF yes:
    STOP - Don't add it. Put it in test utilities instead

  Ask: "Does this class own this resource's lifecycle?"
  IF no:
    STOP - Wrong class for this method
```

### When mocks become too complex

Warning signs:

- Mock setup longer than test logic
- Mocking everything to make the test pass
- Mocks missing methods real components have
- Test breaks when the mock changes

Integration tests with real components are often simpler than complex mocks. Ask: *"Do we need to be using a mock here?"*

## Tests Ship With the Implementation

```
❌ "Implementation complete. No tests written. Ready for testing."
✅ TDD cycle:
   1. Write failing test
   2. Implement to pass
   3. Refactor
   4. THEN claim complete
```

Testing is part of implementation, not an optional follow-up. You can't claim complete without tests — and only the tests the behavior needs.

## TDD Prevents These Anti-Patterns

1. **Write test first** → forces you to think about what you're actually testing
2. **Watch it fail** → confirms the test tests real behavior, not mocks
3. **Minimal implementation** → no test-only methods creep in
4. **Real dependencies** → you see what the test actually needs before mocking

If you're testing mock behavior, you violated TDD — you added mocks without watching the test fail against real code first.

## The Mutation Check

Before finishing, mentally mutate the production code; at least one test should fail for each realistic mutation:

- Wrong constant or argument
- Wrong branch handler
- Missing state change or side effect
- Empty or default return
- Missing validation for zero, empty, nil, unauthorized, or malformed input

A mutation nothing catches marks the behavior as unprotected — or the test as tautological.

## Quick Reference

| When you... | Do |
|-------------|-----|
| Write any test | Name the break it catches — a bug, not a decision |
| Build an expected value | Derive it by hand; never with the code under test |
| Test a script or document | Run it and assert its effects; never grep its text |
| Reach for a dependency test | Test your boundary contract, not their documented mechanics |
| Want to assert on a mocked element | Test the real component, or unmock it |
| Are about to mock a method | Learn its side effects; mock the slow/external level |
| Build a mock response | Mirror the real structure completely |
| Need cleanup only tests use | Put it in test utilities, never production classes |
| Watch mock setup balloon | Switch to an integration test with real components |
| Finish implementation | Tests ship with it — TDD, not afterthought |
| Finish a test file | Run the mutation check |

## Warning Signs

- Setup and assertion share the same object, guaranteeing equality
- The test can fail only through a panic, crash, or missing selector
- The test fails on every intentional change, never on accidental breakage
- Expected values are hidden behind loops, builders, or helpers
- The test greps source text, or asserts a removed symbol stays removed
- The test would still matter if only the framework remained
- The test exists for coverage, checking no side effect or outcome
- An assertion checks a `*-mock` test ID, or fails if you remove the mock
- A method is called only from test files
- Mock setup is more than half the test, or you can't explain why the mock is needed
- The test fails when you remove the mock
- Mocking "just to be safe"

## The Bottom Line

**Mocks are tools to isolate, not things to test.**

If TDD reveals you're testing mock behavior, you've gone wrong. Fix: test real behavior or question why you're mocking at all.

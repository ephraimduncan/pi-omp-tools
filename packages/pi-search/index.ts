/**
 * pi-search: registers the `search` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerSearch, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerSearch(pi);
}

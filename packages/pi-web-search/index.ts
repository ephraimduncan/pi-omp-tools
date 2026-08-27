/**
 * pi-web-search: registers the `web_search` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerWebSearch, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerWebSearch(pi);
}

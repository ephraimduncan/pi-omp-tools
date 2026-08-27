/**
 * pi-browser: registers the `browser` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerBrowser, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerBrowser(pi);
}

/**
 * pi-find: registers the `find` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerFind, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerFind(pi);
}

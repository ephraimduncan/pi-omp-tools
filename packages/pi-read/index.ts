/**
 * pi-read: registers the `read` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerRead, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerRead(pi);
}

/**
 * pi-write: registers the `write` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerWrite, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerWrite(pi);
}

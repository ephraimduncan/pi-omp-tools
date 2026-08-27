/**
 * pi-ask: registers the `ask` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerAsk, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerAsk(pi);
}

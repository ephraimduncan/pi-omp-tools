/**
 * pi-ask: registers the `ask` tool from @ephraimduncan/omp-tools-core.
 */
import { registerAsk, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerAsk(pi);
}

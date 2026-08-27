import { registerLazyPrimeGates } from "./src/gates.ts";
import type { GateHost } from "./src/host.ts";

/** Install the Lazy Prime policy gates in pi or Prime Agent. */
export default function lazyPrimeGates(host: GateHost): void {
	registerLazyPrimeGates(host);
}

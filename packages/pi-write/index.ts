/**
 * pi-write: registers the `write` tool from @ephraimduncan/omp-tools-core.
 */
import { registerWrite, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerWrite(pi);
}

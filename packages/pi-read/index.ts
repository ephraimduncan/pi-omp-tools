/**
 * pi-read: registers the `read` tool from @ephraimduncan/omp-tools-core.
 */
import { registerRead, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerRead(pi);
}

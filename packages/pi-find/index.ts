/**
 * pi-find: registers the `find` tool from @ephraimduncan/omp-tools-core.
 */
import { registerFind, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerFind(pi);
}

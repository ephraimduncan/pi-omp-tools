/**
 * pi-hashline-edit: registers the `edit` tool from @ephraimduncan/omp-tools-core.
 */
import { registerEdit, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerEdit(pi);
}

/**
 * pi-ast-edit: registers the `ast_edit` tool from @ephraimduncan/omp-tools-core.
 */
import { registerAstEdit, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerAstEdit(pi);
}

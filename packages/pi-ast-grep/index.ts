/**
 * pi-ast-grep: registers the `ast_grep` tool from @ephraimduncan/omp-tools-core.
 */
import { registerAstGrep, type PiApi } from "@ephraimduncan/omp-tools-core";

export default function (pi: PiApi): void {
	registerAstGrep(pi);
}

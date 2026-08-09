/**
 * pi-ast-grep: registers the `ast_grep` tool from @ephraimduncan/omp-tools-core.
 */
import { registerAstGrep, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerAstGrep(pi);
}

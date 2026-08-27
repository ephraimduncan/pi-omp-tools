/**
 * pi-ast-grep: registers the `ast_grep` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerAstGrep, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerAstGrep(pi);
}

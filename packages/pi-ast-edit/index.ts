/**
 * pi-ast-edit: registers the `ast_edit` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerAstEdit, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerAstEdit(pi);
}

/**
 * pi-todo: registers the `todo` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerTodo, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerTodo(pi);
}

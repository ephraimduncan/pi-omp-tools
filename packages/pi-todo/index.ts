/**
 * pi-todo: registers the `todo` tool from @ephraimduncan/omp-tools-core.
 */
import { registerTodo, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	registerTodo(pi);
}

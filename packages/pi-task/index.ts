/**
 * pi-task: registers the `task` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerTask, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerTask(pi);
}

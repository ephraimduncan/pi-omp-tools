/**
 * pi-task: registers the `task` tool from @ephraimduncan/omp-tools-core.
 */
import { registerTask, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerTask(pi);
}

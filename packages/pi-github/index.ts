/**
 * pi-github: registers the `github` tool from @ephraimduncan/omp-tools-core.
 */
import { registerGithub, type PiApi } from "@ephraimduncan/omp-tools-core";

export default async function (pi: PiApi): Promise<void> {
	await registerGithub(pi);
}

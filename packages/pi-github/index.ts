/**
 * pi-github: registers the `github` tool from @ephraimduncan/lazy-prime-core.
 */
import { registerGithub, type PiApi } from "@ephraimduncan/lazy-prime-core";

export default async function (pi: PiApi): Promise<void> {
	await registerGithub(pi);
}

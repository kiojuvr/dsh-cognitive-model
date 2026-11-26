/**
 * Structural declarations for the host surface this plugin uses.
 *
 * The plugin imports nothing from `@deepseek-ai/*`: the host supplies `ctx`,
 * and structural typing keeps this package installable without pinning a
 * specific DSH release's type packages.
 *
 * Verified against DSH 0.2.2-rc.3:
 *   - `ctx.tools.register(definition)`      (`@deepseek-ai/dsh-tools`, ToolsService)
 *   - `ctx.systemPrompt.section(section)`   (`@deepseek-ai/dsh-system-prompt`)
 *   - `ctx.systemPrompt.context(context)`   (`@deepseek-ai/dsh-system-prompt`)
 *   - `exec.agent.sessionId`, `exec.agent.session.header.cwd`
 *     (`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`)
 */
/**
 * The session id a reader is identified by, from either shape the host uses.
 *
 * The recall's "once" is once per session (D100), so the prompt provider and
 * the write tools must read the same id from the same places.
 */
export function sessionIdOf(agent) {
    const direct = agent?.sessionId;
    if (typeof direct === 'string' && direct !== '')
        return direct;
    const mirrored = agent?.session?.header?.id;
    return typeof mirrored === 'string' && mirrored !== '' ? mirrored : undefined;
}

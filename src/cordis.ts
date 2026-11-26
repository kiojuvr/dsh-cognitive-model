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

/** Raw JSON Schema as accepted by `ctx.tools.register`. */
export type JsonSchema = Record<string, unknown>

export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ToolOutputDefinition {
  readonly schema: JsonSchema
  render(args: unknown, value: unknown): ContentBlock[]
  /**
   * Pure, replayable UI projection persisted on `tool/result` (`result.meta`).
   * Client cards read it instead of parsing the model-facing text.
   */
  presentationMeta?(args: unknown, value: unknown): unknown
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** The slice of a DSH Agent this plugin reads. */
export interface AgentLike {
  /** Present on an AgentHandle; the tool context usually receives the Agent. */
  readonly sessionId?: string
  readonly session?: {
    /** `SessionHeader.id` mirrors the Session's own id. */
    readonly header?: { readonly id?: string; readonly cwd?: string }
  }
}

export interface ToolRunContext {
  readonly signal?: AbortSignal
  readonly agent?: AgentLike
  readonly callId?: string
}

/**
 * The session id a reader is identified by, from either shape the host uses.
 *
 * The recall's "once" is once per session (D100), so the prompt provider and
 * the write tools must read the same id from the same places.
 */
export function sessionIdOf(agent: AgentLike | undefined): string | undefined {
  const direct = agent?.sessionId
  if (typeof direct === 'string' && direct !== '') return direct
  const mirrored = agent?.session?.header?.id
  return typeof mirrored === 'string' && mirrored !== '' ? mirrored : undefined
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
}

export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}

/** The assembly context handed to prompt contributors. */
export interface AssembleContextLike {
  readonly scope?: unknown
  readonly signal?: AbortSignal
  /**
   * The agent whose prompt is being assembled. `@deepseek-ai/dsh-system-prompt`
   * declares only `scope`/`signal`; other packages merge this field in, and the
   * host populates it.
   */
  readonly agent?: AgentLike
}

export interface Context {
  readonly tools: {
    register(definition: ToolDefinition): () => void
  }
  readonly systemPrompt: {
    section(section: PromptSection): () => void
    context(context: PromptContext): () => void
  }
  /**
   * Present when the profile composes `@deepseek-ai/dsh-session-projection`.
   * Optional here: the graph's tools and prompt work without a UI consumer.
   */
  readonly sessionProjections?: SessionProjectionsService
  /**
   * Start a child plugin once these services exist. Used for optional
   * capabilities so the plugin still works without them.
   */
  inject?(deps: string[], callback: (ctx: Context) => void): unknown
  /** Cordis event subscription; `prepend` places a waterfall listener first. */
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): () => void
  /** Cordis service lookup; used only for optional, defensive access. */
  get?(name: string): unknown
  /**
   * Register a service on this plugin's fiber. Cordis disposes it with the
   * plugin; other plugins read it with `ctx.get(name)`.
   */
  provide?(name: string, value: unknown): unknown
}

/** The slice of a session header the projection reads. */
export interface SessionHeaderLike {
  readonly cwd?: string
}

/** A log-derived per-session value, as `@deepseek-ai/dsh-session-projection` defines it. */
export interface SessionProjectionDefinition<TState = unknown> {
  readonly key: string
  /** Bumped when the fold semantics change, so cached checkpoints are discarded. */
  readonly stateVersion: number
  readonly stateSchema: { parse(value: unknown): TState }
  init(header: SessionHeaderLike | undefined): TState
  apply(state: TState, event: { type?: string } | undefined): TState
  readonly wire: {
    readonly viewSchema: { parse(value: unknown): unknown }
    view(state: TState): unknown
  }
}

export interface SessionProjectionsService {
  register(definition: SessionProjectionDefinition<any>): Promise<unknown> | unknown
}

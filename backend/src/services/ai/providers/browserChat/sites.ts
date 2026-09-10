import type { AIProvider } from '../../../../types/template';

/**
 * Everything that differs between one chat UI and another.
 *
 * Both sites need identical machinery - start a fresh conversation, type the
 * prompt, wait for the reply to stop growing, read it - and differ only in
 * which nodes those are. So the machinery lives in `conversation.ts` once and
 * each site contributes selectors.
 *
 * Every role is a CANDIDATE LIST, not a selector, and every list is overridable
 * from the environment. That is not defensiveness for its own sake: chatgpt.com
 * and claude.ai publish no markup contract and both have changed the
 * attributes below more than once. A list ordered most-specific-first with a
 * broader fallback behind it survives one rename without a release; the
 * environment override survives the next one without waiting for one.
 */
export type ChatSiteId = Extract<AIProvider, 'claude-web' | 'chatgpt-web'>;

export type ChatSite = {
  id: ChatSiteId;
  label: string;
  /** Loaded to start a conversation, and what a usable tab must be showing. */
  url: string;
  /** Host a tab must be on to be this site's tab. */
  host: string;
  composer: string[];
  send: string[];
  /** Present ONLY while the model is generating. */
  busy: string[];
  /**
   * An ASSISTANT message.
   *
   * The one role with no broad fallback, deliberately. A candidate that also
   * matched the user's own turn would hand the prompt back as the answer -
   * no error, no empty reply, just a resume tailored to the instructions
   * instead of the job. `isEcho` is the backstop; not offering a generic
   * candidate here is the prevention.
   */
  assistant: string[];
  /** The site's own new-chat control. Optional: reloading `url` also works. */
  newChat: string[];
  /** Attribute that identifies a message, where the site has one. */
  messageIdAttr: string | null;
  /** Appended to every prompt. */
  nudge: string;
};

/**
 * Keep the answer in the message, where it can be read.
 *
 * Both sites will move a long answer somewhere the message does not contain -
 * ChatGPT's canvas, Claude's artifacts panel - and a reader that only sees the
 * message then gets prose about an answer instead of the answer. Asking costs
 * one sentence; scraping the panel costs a lot more.
 *
 * It does NOT ask for a fenced block. This app's replies are prose and JSON
 * written into the chat, and a nudge demanding code fences would put the two
 * prompts that want prose - the cover letter, the bid answer - inside a code
 * block for no reason.
 */
const NUDGE =
  'Reply directly in this chat with the answer itself and nothing else: no preamble, ' +
  'no explanation afterwards, and no follow-up question. Do not use canvas, do not ' +
  'create an artifact, and do not try to run, compile or test anything.';

const CLAUDE_WEB: ChatSite = {
  id: 'claude-web',
  label: 'Claude (browser)',
  url: 'https://claude.ai/new',
  host: 'claude.ai',
  composer: [
    'div[contenteditable="true"].ProseMirror',
    '[data-testid="chat-input"] div[contenteditable="true"]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"]',
  ],
  send: [
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
  ],
  busy: [
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop"]',
    'div[data-is-streaming="true"]',
  ],
  assistant: ['div[data-is-streaming]', 'div.font-claude-message', '[data-testid="assistant-message"]'],
  newChat: ['a[href$="/new"]', 'button[aria-label="New chat"]', 'a[aria-label="New chat"]'],
  // claude.ai has no per-message id to rely on, so the reply is identified by
  // position - sound because every call starts a fresh conversation.
  messageIdAttr: null,
  nudge: NUDGE,
};

const CHATGPT_WEB: ChatSite = {
  id: 'chatgpt-web',
  label: 'ChatGPT (browser)',
  url: 'https://chatgpt.com/',
  host: 'chatgpt.com',
  composer: ['#prompt-textarea', 'div[contenteditable="true"]'],
  // Both spellings, newest first: a live page was seen using `chat-input-send`
  // where only `send-button` had ever been known.
  send: [
    '[data-testid="chat-input-send"]',
    '[data-testid="send-button"]',
    'button[aria-label*="Send"]',
  ],
  busy: [
    '[data-testid="chat-input-stop"]',
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
  ],
  assistant: ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]', '.agent-turn'],
  newChat: ['[data-testid="create-new-chat-button"]', 'button[aria-label*="New chat"]'],
  messageIdAttr: 'data-message-id',
  nudge: NUDGE,
};

const SITES: Record<ChatSiteId, ChatSite> = {
  'claude-web': CLAUDE_WEB,
  'chatgpt-web': CHATGPT_WEB,
};

export function isChatSiteId(value: unknown): value is ChatSiteId {
  return value === 'claude-web' || value === 'chatgpt-web';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** `A|B|C` from the environment, trimmed, empties dropped. */
function overrideList(raw: string | undefined): string[] | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * The site, with any environment overrides applied.
 *
 * Variables are `AI_WEB_<SITE>_<ROLE>`, e.g.
 * `AI_WEB_CLAUDE_ASSISTANT='div.font-claude-message'`, several candidates
 * separated by `|`. Read fresh rather than cached so a fix can be applied by
 * restarting the backend instead of rebuilding it.
 */
export function readChatSite(id: ChatSiteId, env: NodeJS.ProcessEnv = process.env): ChatSite {
  const base = SITES[id];
  const prefix = id === 'claude-web' ? 'AI_WEB_CLAUDE' : 'AI_WEB_CHATGPT';
  const list = (role: string, fallback: string[]) =>
    overrideList(env[`${prefix}_${role}`]) ?? fallback;

  const url = (env[`${prefix}_URL`] ?? '').trim() || base.url;

  return {
    ...base,
    url,
    // Derived from the URL rather than fixed, so overriding the URL also moves
    // the tab lookup. Fixed, an override would send every call to a NEW tab on
    // the new host and never reuse the one the operator signed in to.
    host: hostOf(url) || base.host,
    composer: list('COMPOSER', base.composer),
    send: list('SEND', base.send),
    busy: list('BUSY', base.busy),
    assistant: list('ASSISTANT', base.assistant),
    newChat: list('NEW_CHAT', base.newChat),
    nudge: typeof env[`${prefix}_NUDGE`] === 'string' ? String(env[`${prefix}_NUDGE`]) : base.nudge,
  };
}

import { getUserConfig } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty, upperFirst } from 'lodash-es'
import { getCustomApiPromptBase, pushRecord, setAbortController } from './shared.mjs'

const MODEL_FORMATTERS = {
  Default: (prompts) => prompts.map((p) => `${p.role}\n${p.content}`).join('\n') + '\n',
  OpenChat: (prompts) =>
    prompts.map((p) => `GPT4 Correct ${upperFirst(p.role)}: ${p.content}`).join('\n') +
    'GPT4 Correct Assistant:',
  Zephyr: (prompts) => prompts.map((p) => `<|${p.role}|>\n${p.content}`).join('\n') + '\n',
  Phi2: (prompts) =>
    prompts
      .map((p) => `${p.role == 'assistant' ? 'Output: ' : 'Instruct: '}${p.content}`)
      .join('\n') + '\nOutput:',
  ['open-llama-3b-v2-wizard-evol-instuct-v2']: (prompts) =>
    prompts
      .map((p) => `${p.role == 'assistant' ? '### RESPONSE:\n' : '### HUMAN:\n'}${p.content}`)
      .join('\n') + '\n### RESPONSE:',
}

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} modelSerial
 */
export async function generateAnswersWithLlamaCppApi(port, question, session, modelSerial) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)

  const config = await getUserConfig()
  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )
  prompt.unshift({ role: 'system', content: await getCustomApiPromptBase() })
  prompt.push({ role: 'user', content: question })

  let answer = ''
  await fetchSSE(`http://localhost:8080/completion`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: (MODEL_FORMATTERS[modelSerial] ?? MODEL_FORMATTERS.Default)(prompt),
      stream: true,
      stop: ['</s>', '<|end_of_turn|>'],
      n_predict: config.maxResponseTokenLength,
      temperature: config.temperature,
    }),
    /**
     *
     * @param {string} message
     * @returns
     */
    onMessage(message) {
      console.debug('sse message', message)
      /**
       * @type {{content:string,stop:boolean}}
       */
      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.debug('json error', error)
        return
      }

      if (data.stop) {
        pushRecord(session, question, answer)
        console.debug('conversation history', { content: session.conversationRecords })
        port.postMessage({ answer: null, done: true, session: session })
        return
      }

      answer += data.content
      port.postMessage({ answer: answer, done: false, session: null })
    },
    async onStart() {},
    async onEnd() {
      port.postMessage({ done: true })
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
    },
    async onError(resp) {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
      if (resp instanceof Error) throw resp
      const error = await resp.json().catch(() => ({}))
      throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
    },
  })
}

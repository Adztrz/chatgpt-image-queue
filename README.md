# Tampermonkey scripts

## ChatGPT Prompt Queue

`chatgpt-prompt-queue.user.js` sends a list of prompts to ChatGPT one at a time, each after the previous reply or image has finished.

**Install:** in Tampermonkey's dashboard, click **+**, replace the editor's contents with the file, save, then reload ChatGPT.

**Use:** click **Queue**, paste one prompt per line, click **Load**, then **Start**. Don't type in the chat box while it runs.

It pauses on a limit message, a reply over 8 minutes, a page reload, or if it can't send. **Check page** shows what the script can find, for when ChatGPT changes its page.

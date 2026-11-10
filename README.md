# ChatGPT Tampermonkey Image Queue

A Tampermonkey userscript that queues image prompts in ChatGPT. Paste a list, and `chatgpt-prompt-queue.user.js` sends them one at a time, each after the previous image has finished.

**Install:** with Tampermonkey installed, open [the raw script](https://raw.githubusercontent.com/Adztrz/chatgpt-image-queue/main/chatgpt-prompt-queue.user.js): Tampermonkey offers to install it and keeps it up to date from here. Or by hand: in Tampermonkey's dashboard, click **+**, replace the editor's contents with the file, save, then reload ChatGPT (a copy pasted by hand doesn't update itself).

**Use:** click **Queue**, paste one prompt per line, click **Load prompts**, then **Start**. Each prompt gets its own card showing whether it's queued, next, generating or sent; click a card's text to see the whole prompt. Don't type in the chat box while it runs.

It pauses on a limit message, a reply over 8 minutes, a page reload, or if it can't send. **Check** shows what the script can find, for when ChatGPT changes its page.

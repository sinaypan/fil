<img src="icons/icon128.png" width="88" alt="">

# Fil

A Chrome extension to reread a Messenger conversation you exported, and to remember it. It cuts years of messages into real conversations, gets each one summarised and tagged by the LLM of your choice, and lets you find anything again: by words, by mood, by period, or by asking a question in plain language.

It was made for one long conversation written in Algerian darja, French and English, all mixed together, by someone who keeps forgetting what was said.

<img src="screenshots/summary.png" width="100%" alt="A conversation open on its summary: title, tags, key points, and the list of conversations on the left">

## What it does

- **Conversations, not days.** A conversation ends after a silence (1 hour by default, or 30 min, 2 h, 3 h). One that goes from 23:00 to 00:30 stays in one piece. You can merge two conversations, or cut one with the scissors that show up when you hover a message. An LLM can also settle the doubtful silences, the ones close to the limit, by reading the messages around them. Your corrections always win over the LLM's.
- **Summary or messages.** Each conversation opens on its summary (a title, the points worth remembering, tags), with its messages one click away.
- **Summaries and tags from your LLM.** Any OpenAI-compatible service works: OpenAI, LiteLLM, OpenRouter, Ollama… One conversation at a time, or a whole period in one go. Summaries are saved: nothing is ever sent twice unless you ask to redo it. Tags come in two families, topics and moods. The LLM must reuse the existing list, and you can rename, merge or delete tags without calling the LLM again.
- **Changing the cut loses nothing.** Every summary is kept for the cut it was made with. When a longer conversation contains several summarised ones, it shows them end to end without asking the LLM.
- **Search that knows darja written in Latin letters.** `khdma` finds `khedma`, `3lach` finds `alach`. Search also looks in titles, tags and summaries, so a French word finds a conversation that was written in darja. You can type several words (in any order), `"an exact phrase"`, or `-word` to leave some out. Results are grouped by conversation and ranked, with the messages before and after each hit.
- **Ask a question.** "When did we plan the brunch?": the LLM answers from your summaries and links to the conversations it used. Answers are kept, so asking again costs nothing.

<img src="screenshots/search.png" width="100%" alt="Search results for two words, with the answer to the question at the top and links to the conversations">

- **Timeline.** Every conversation is a bar, as wide as it lasted; the periods you have not imported yet are hatched. Zoom with the mouse wheel and move along with Shift + wheel. Drag across it to pick a period, then summarise it, filter on it or zoom on it. A band under the bars shows the moods week by week.

<img src="screenshots/timeline.png" width="100%" alt="The timeline with a selected period, the mood band under it and the list of selected conversations">

- **Filters and sorting.** By period (with a calendar), tags, status, size. Sort by date, length, number of messages, silence before, or favourites. The filters apply everywhere at once.
- **Chapters.** A summary of the summaries for each week and each month, to reread a whole month in a minute.
- **À retenir.** Promises, plans, dates, open questions and facts, picked from the summaries month by month, each with a link to its conversation and a box to tick when it is done.
- **People and places.** Who is who, and in which conversations.

<img src="screenshots/chapters.png" width="100%" alt="Monthly chapters: a title, the mood of the month and its main points">

<img src="screenshots/remember.png" width="100%" alt="The list of things to remember, by type, with links to the conversations">

- **Analysis.** Figures for each person (share of messages, words per message, reply time, who starts conversations, questions, messages at night, emojis), the languages each one uses, when you write (day × hour), messages per week, and moods month by month. Everything is worked out on your computer.
- **Portrait.** A description of how each person writes and reacts, and of how the exchange works between you, written by the LLM from the summaries, the figures and 40 messages of each person. It describes habits only: the instructions forbid diagnoses, psychological labels and judgements, and every point must point to the conversations it comes from.

<img src="screenshots/analysis.png" width="100%" alt="The analysis tab: figures for each person and the languages they use">

<img src="screenshots/portrait.png" width="100%" alt="The portrait of both people and of the relationship, with links to conversations">

- **Later exports fill the gaps.** Importing a newer or longer export shows first what it would add on the timeline. Messages that are already there are never overwritten; only the missing periods are added.
- **Export.** Months, weeks, conversations, things to remember, people and places, as a Word file or as a PDF.
- **Backup.** One file with everything (messages, summaries, tags, chapters, ticks), to put back after reinstalling. It never contains your LLM key.

<img src="screenshots/filters.png" width="100%" alt="The filter panel: period, tags, status, size and sort">

The interface is in French. The conversation in the screenshots is made up for the demonstration.

## Install

The extension is not on the Chrome Web Store, so it is loaded by hand:

1. Download this repository (**Code**, then **Download ZIP**) and unzip it, or clone it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder.
4. Click the Fil icon in the toolbar: it opens the reading tab.

## Getting your conversation

Conversations that are end-to-end encrypted are not in Facebook's usual "Download your information". In Messenger: **Preferences › Privacy and safety › End-to-end encrypted chats › Message storage › Download secure storage data**. Choose **All time**. You get one JSON file per conversation: import the one you want, or drop it on the page.

Messenger does not include photos and videos in that export; Fil shows where they were.

## Connecting an LLM

Open the settings (the sliders button, bottom left) and give the address of an OpenAI-compatible API (ending in `/v1` or in `/chat/completions`), the model and the key. Chrome then asks to let Fil reach that one site, and nothing else. "Enregistrer et tester" sends a one-word request to check it works.

Without an LLM, Fil still reads, cuts, searches and counts, and each conversation has a button to copy it with summary instructions, to paste into any chat assistant.

## What it cannot do

- **Photos, videos and voice messages.** They are not in the export.
- **Several conversations at once in one view.** Each conversation is imported and read on its own.
- **Read the export straight from Messenger.** You download it, then import it.
- **Guarantee the LLM's work.** Summaries, tags, chapters, portraits and answers are written by a model and can be wrong or miss things. Every one of them links back to the messages so you can check.
- **Recognise every language perfectly.** The language figures are guessed from common words; short messages ("ok", "hhh", an emoji) are counted apart.

## Privacy

Everything stays in the extension's own storage on your computer. Fil has no server and makes no request on its own. The only requests are the ones you trigger, to the LLM you configured: the messages of the conversations you ask to summarise, tag or check, the summaries for chapters, questions and the portrait, and 40 messages of each person for the portrait. Nothing else leaves your computer.

The LLM key is kept in the extension's storage, not encrypted, and is never put in backups. Uninstalling the extension deletes everything it stored: keep a backup.

| Permission | Why it is needed |
| --- | --- |
| Access to the site of your LLM (asked when you save the settings) | Send the requests you trigger to the service you chose. Fil asks for that one site only |

## License

[MIT](LICENSE) © 2026 Yanis Arris

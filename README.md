# LINE Family Fact-Check Bot

**What this is:** a LINE bot that checks forwarded articles in your family group chat. Someone posts a news link, the bot checks it with Google's free Gemini AI and replies gently, with source links. It lives in Google Apps Script, so you don't need your own server. It costs $0.

**You don't need to know how to code.** You only need to copy, paste, and click. It takes about 30 minutes.

## Before you start

You need:

1. A Google account (Gmail)
2. A LINE account
3. About 30 minutes

Some words you will see, in plain language:

- **API key** — like a password that lets this code use Gemini (Google's AI)
- **Channel access token** — like a password that lets this code send messages as your LINE bot
- **Webhook URL** — the address LINE uses to send messages to the code
- **Deploy** — publish the code, so LINE can reach it on the internet
- **Script properties** — a safe place inside Apps Script to store the passwords above

---

## Part 1: Get a free Gemini key (about 5 minutes)

1. Open your browser and go to **aistudio.google.com**
2. Sign in with your Google account
3. On the left menu, click **Get API key**
4. Click **Create API key**
5. If it asks you to pick or create a project, just click through — accept the default
6. A long code appears. **Copy it and save it somewhere safe** (for example in a note on your phone). This is your Gemini key. It is like a password — don't post it in any chat
7. Done. You don't need to pay anything, and no credit card is needed

## Part 2: Create the LINE bot account (about 10 minutes)

1. Go to **manager.line.biz** and sign in with your LINE account
2. Click **Create** to make a new Official Account
3. Give it a name, for example `查核小幫手`. Set the country to Taiwan. Finish the setup
4. After the account is created, find **Settings** in the left menu, then find **Messaging API**, and turn it on
5. Now go to **developers.line.biz** and sign in with the same LINE account
6. Click your channel (the account you just made)
7. Click the **Messaging API** tab at the top of the page
8. Find **Channel access token** and click **Issue**. A long code appears — **copy it and save it somewhere safe**. This is your LINE token
9. On the same page, find **Allow bot to join group chats** and turn it **ON**. It is OFF by default. If you skip this step, the bot can never enter a group
10. Keep this page open in a tab — you will come back to it in Part 4

## Part 3: Put the code in Google Apps Script (about 10 minutes)

1. Go to **script.google.com** and sign in with your Google account
2. Click **New project**
3. You will see a page with some sample code on it (it starts with `function myFunction`). Select all of it and delete it
4. Open the file **`Code.gs`** from this repo. Select all of it and copy it
5. Paste it into the Apps Script page
6. Save: click the disk icon, or press Ctrl+S (Windows) / Cmd+S (Mac)
7. At the top, click **Untitled project** and name it `LINE Fact Check Bot`
8. On the left side, click the **gear icon** (Project Settings)
9. Click **Script properties**, then **Add script property**. Add these 4, one by one. For each one, type the name, type the value, and click **Save script property**:

   | Name (type exactly) | Value |
   |---|---|
   | `LINE_CHANNEL_ACCESS_TOKEN` | The LINE code from Part 2, step 8 |
   | `GEMINI_API_KEY` | The Gemini key from Part 1, step 6 |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
   | `WEBHOOK_TOKEN` | Make up your own random letters and numbers, for example `aB3x9qZ7kL2`. Write it down — you need it in Part 4 |

10. Done. Your code and passwords are saved

## Part 4: Publish the code and connect LINE (about 5 minutes)

1. In Apps Script, at the top right, click **Deploy**, then **New deployment**
2. Click the gear icon next to "Select type" and choose **Web app**
3. **Execute as:** choose **Me**
4. **Who has access:** choose **Anyone**
5. Click **Deploy**. Google will ask for permission — choose your account and click **Allow**
6. A web address (URL) appears. It ends with `/exec`. **Copy it**
7. Now add your token to the end of that address. It should look like this:

   ```
   https://script.google.com/macros/s/ABC123/exec?token=aB3x9qZ7kL2
   ```

   Replace `ABC123` with your real address, and `aB3x9qZ7kL2` with the `WEBHOOK_TOKEN` you made in Part 3, step 9
8. Go back to the LINE Developers page from Part 2. Paste this full address into the **Webhook URL** box
9. Click **Verify**. It should say success
10. Turn **Use webhook** ON

## Part 5: Test it first (do this before the group)

1. In LINE, add your new bot account as a friend. Search for its name in LINE, or scan its QR code (you can find the QR code in the Official Account Manager)
2. Send it a message. Try one of these:
   - Paste a news link
   - Type: `查 台積電要被美國罰款是真的嗎`
3. Wait a few seconds. It should reply with a check and source links
4. If it replies, it works. If it doesn't, see "If something goes wrong" below

## Part 6: Invite it to the family group

1. Open the family group chat in LINE
2. Tap the group name at the top → **Invite** → choose your bot account → **Invite**
3. Post a news link in the group. The bot should reply in the group
4. Done. Group members can also type `查` + a question, or @ the bot

## How to use it (for group members)

- **Post a news link** — the bot checks it by itself
- **Type `查` + your question** — for example: `查 普拿疼可以每天吃嗎`
- **Type `!fact` + your question** — same thing, in English
- **@ the bot** — type @ and pick the bot, then write your question
- **In a private chat with the bot** — any message works, and you can also send it a photo or screenshot to check

## What it costs

$0. Here is why:

- Gemini (Google's AI) is free for this amount of use — about 100 to 1000 questions a day. A family group asks far fewer than that
- LINE does not charge for replies. The bot only replies when someone talks to it — it never sends messages by itself
- Google Apps Script is free

## If something goes wrong

| What happens | What to do |
|---|---|
| Webhook **Verify** fails | The address is wrong, or the `?token=` part does not match the `WEBHOOK_TOKEN` you saved in Part 3. Check both and try again. Also check the deployment access is set to **Anyone** (Part 4, step 4) |
| The bot says nothing at all | In Apps Script, click the **clock icon** on the left (Executions). If there is nothing there, the message never reached the code — check the webhook URL again. If there is an error message there, read it and check the table below |
| The bot replies: 今天問太多了 | The free daily limit is used up. Wait until tomorrow |
| The bot replies: 模型名稱可能已退役 | Google retired that AI model name. Go to Google AI Studio and see the current free Flash model name, then change `GEMINI_MODEL` in Script properties (Part 3, step 9) and save |
| It works in private chat but not in the group | **Allow bot to join group chats** is still OFF (Part 2, step 9), or the bot has not been invited to the group yet (Part 6) |
| The bot replies very slowly or not at all | The AI sometimes takes more than 50 seconds, and LINE only waits 1 minute. Just ask again — it usually works the second time |

## Safety — please read

- **Never share the 3 codes** (Gemini key, LINE token, webhook token). They are passwords. Don't post them in any group chat, and don't put them in the code itself — they belong in Script properties only
- **Don't share the webhook address.** It has your secret token in it
- The free Gemini service may use your messages to improve Google's products, so don't send anything private

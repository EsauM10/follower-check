# Follower Check

**English** | [Português](README.pt-BR.md)

Chrome extension that lists the Instagram accounts you follow that don't follow you back.

## Installation

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right corner).
3. Click **Load unpacked** and select this repository's folder (the one containing `manifest.json`).

## Usage

1. Log in at https://www.instagram.com.
2. Click the extension icon. The panel opens in the corner of the page.
3. Click **Scan followers**.

The panel follows your browser's language (English or Portuguese).

It has three tabs:

- **Not following back**: accounts you follow that don't follow you back.
- **You don't follow**: accounts that follow you that you don't follow.
- **Ignored**: accounts you chose to hide from the first tab (artists, brands, etc.).

You can also search, hide verified accounts, copy the @s, export a CSV and unfollow straight from the panel (it asks for confirmation first).

Results are saved in the browser (`chrome.storage.local`), so you can close the panel and reopen it without scanning again.

## How it works

The extension calls the same internal API the Instagram website uses, with the session already logged in to your browser:

- `GET /api/v1/friendships/{id}/following/`
- `GET /api/v1/friendships/{id}/followers/`
- `POST /api/v1/friendships/destroy/{id}/` (unfollow)

No data leaves your browser.

## Caveats

- Instagram limits how many requests you can make. The extension waits between pages and pauses on its own when Instagram asks it to slow down. Accounts with thousands of followers can take a few minutes to scan.
- Don't unfollow dozens of accounts in a row: Instagram may temporarily block the action.
- The API is unofficial and can change without notice.

## Disclaimer

Personal, open-source project with no affiliation with Instagram or Meta. "Instagram" is a trademark of Meta Platforms, Inc.

The extension uses internal, undocumented Instagram endpoints. Automating access to the service may violate [Instagram's Terms of Use](https://help.instagram.com/581066165581870) and lead to temporary blocks or account restrictions. Use at your own risk.

## License

[MIT](LICENSE)

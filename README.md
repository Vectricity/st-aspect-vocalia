# Aspect: Vocalia

Aspect: Vocalia is a SillyTavern extension for intelligently automating character responses in group chats.

## What It Does

- Makes group chats scene-aware instead of leaving speaker choice to random routing
- Tracks who is present, remote, absent, arriving, or departing
- Lets user messages summon characters, contact them remotely, or leave them behind
- Routes who should speak next, including multi-character turns
- Keeps response chains under control with per-turn limits
- Uses structured replies for dialogue, actions, narration, and thoughts
- Renders those structured replies into cleaner, easier-to-read chat messages with styling options
- Can hide message history from characters who did not witness them

## Scene Presence

Maintains scene state for each enabled group chat participant.

Available scene states include:
- Present (physically in the active scene)
- Remote (not physically present, but are actively reachable through a channel such as phone, radio, video, intercom, text, or similar communication)
- Absent (neither physically present nor remotely connected)
- Arriving (staged to enter the scene, either immediately or after the current automatic response chain ends, depending on the configured arrival mode)

Vocalia can update these states from both user messages and assistant metadata.

Examples of user-side signals Vocalia can recognize include:
- Calling or summoning a named absent character into the scene
- Contacting a named character by phone, radio, text, or similar channel
- Physically encountering or noticing a named absent character
- Explicitly leaving a character behind
- Telling a character to wait or stay behind

## Raw Messages

Uses a structured assistant-response format so the active speaker, visible roleplay content, and routing metadata remain separate.

Assistant messages are structured as follows:

```json
    [character=Exact Active Speaker Name]
    [dialogue]spoken words only[end dialogue]
    [actions]active speaker physical action, expression, or gesture only[end actions]
    [narration]scene, environment, or consequences not performed by the active speaker[end narration]
    [thoughts]active speaker private thought only[end thoughts]
    [parameters]speakingTo=ExactName|user|none, participationNextTurn=speak|idle|departing, arriving=ExactName|none, remote=ExactName|none[end parameters]
    [end character]
```
	
## Refined Messages

Turns Raw Messages into clean, readable roleplay text without changing the structured message beneath.

Refined Messages can display:
    "spoken dialogue"
    active speaker actions
    scene narration
    private thoughts

Their appearance can be adjusted by:
- showing or hiding character label
- showing or hiding thoughts
- wrapping dialogue in quotes
- styling actions, narration, and thoughts separately

## Turn Flow

Overrides Group Reply Strategy.

It can:
- Select an opening speaker from a named mention, direct summon, remote contact, or configured fallback
- Limit how many unique characters participate after one user message
- Limit how many total assistant messages may occur after one user message
- Limit how many times the same participant may respond during that turn

## Message Memory

Presence is required for message memory by default.

When enabled, each message is tagged with the characters who witnessed it while they were present or remotely connected. During prompt construction, Vocalia can filter history per active target so a character only recalls messages they actually witnessed.

This allows absent characters to miss off-screen information unless they later learn it in-scene.

Characters can also be given an Omniscience override, allowing them to ignore presence-based recall filtering when desired.

## Support

Please consider tipping a job well done. 

<a href="https://ko-fi.com/genisai">
  <img src="https://github.com/Vectricity/st-aspect-destinia/raw/assets/assets/ko-fi_thumbnail_genisai.png" alt="Support Genisai on Ko-fi" width="400">
</a>

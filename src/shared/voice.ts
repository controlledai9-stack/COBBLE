import type { Member, VoiceDraft } from "./types";
export function parseCommand(text: string, members: Member[]): VoiceDraft {
  const match = text.trim().match(/^(?:message|tell|send to)\s+(.+)$/iu);
  if (!match) return { type: "unrecognized", content: text.trim() };
  const body = match[1];
  const all = body.match(/^(?:all|team)\s+(.+)$/isu);
  if (all) return { type: "broadcast", content: all[1].trim() };
  for (const member of [...members].sort(
    (a, b) => b.name.length - a.name.length,
  )) {
    if (
      body.toLocaleLowerCase().startsWith(`${member.name.toLocaleLowerCase()} `)
    ) {
      const content = body.slice(member.name.length).trim();
      return members.filter(
        (m) => m.name.toLocaleLowerCase() === member.name.toLocaleLowerCase(),
      ).length > 1
        ? { type: "ambiguous", content }
        : { type: "dm", recipientId: member.id, content };
    }
  }
  return { type: "unrecognized", content: text.trim() };
}

import LegacySoloHost from "./LegacySoloHost";
import EmbeddedGameHost, { type EmbeddedGameHostProps } from "./EmbeddedGameHost";

export default function SoloHost(props: Omit<EmbeddedGameHostProps, "onRoomChange"> & {
  onEnterRoom(roomId: string): void;
  onRoomChange(roomId?: string): void;
}) {
  return props.game.embeddedLobby ? <EmbeddedGameHost {...props} /> : <LegacySoloHost {...props} />;
}

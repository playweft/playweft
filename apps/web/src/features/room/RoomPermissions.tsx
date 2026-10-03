import { ClipboardPrompt } from "@/features/permissions/ClipboardPrompt";
import { UserProfilePrompt } from "@/features/permissions/UserProfilePrompt";
import { LanguageModelPermissionPrompt } from "@/features/permissions/LanguageModelPermission";
import GameWindowDialog from "@/features/game/GameWindowDialog";
import type { useRoomGameBridge } from "./useRoomGameBridge";

export default function RoomPermissions({
  bridge,
}: {
  bridge: ReturnType<typeof useRoomGameBridge>;
}) {
  const { clipboard, userProfile, languageModel, windowDialogs } = bridge;
  return (
    <>
      <ClipboardPrompt
        prompt={clipboard.prompt}
        notice={clipboard.notice}
        onAllow={() => void clipboard.allow()}
        onDeny={clipboard.deny}
        onDismissNotice={clipboard.clearNotice}
      />
      <UserProfilePrompt
        prompt={userProfile.prompt}
        onAllow={userProfile.allow}
        onDeny={userProfile.deny}
      />
      <LanguageModelPermissionPrompt
        prompt={languageModel.prompt}
        onAllow={languageModel.allow}
        onDeny={languageModel.deny}
      />
      {windowDialogs.dialog && (
        <GameWindowDialog
          dialog={windowDialogs.dialog}
          onConfirm={windowDialogs.confirm}
          onDismiss={windowDialogs.dismiss}
        />
      )}
    </>
  );
}

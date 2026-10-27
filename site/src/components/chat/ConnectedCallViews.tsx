"use client";

import { memo, type ComponentProps } from "react";
import { useRuntimeState } from "./ChatRuntime";
import { CallOverlay } from "./CallOverlay";
import { VoiceOverlay } from "./VoiceOverlay";
import { VoiceDock } from "./VoiceDock";
import { HeaderCallChip } from "./HeaderCallChip";

type CallContextProps = Pick<ComponentProps<typeof CallOverlay>, "peerAvatarUrl" | "selfAvatarUrl" | "incomingAvatarUrl" | "currentChatId" | "onExpandCall">;
export const ConnectedCallOverlay = memo(function ConnectedCallOverlay(props: CallContextProps) {
  const call = useRuntimeState("call", state => state);
  return <CallOverlay {...props} incoming={call.incoming} active={call.active}
    localStream={call.localStream} remoteStream={call.remoteStream} muted={call.muted} deafened={call.deafened}
    cameraOff={call.cameraOff} sharingScreen={call.sharingScreen} mediaBusy={call.mediaBusy}
    remoteSharingScreen={call.remoteSharingScreen} remoteCameraOff={call.remoteCameraOff} minimized={call.minimized}
    status={call.status} durationLabel={call.durationLabel} networkQuality={call.networkQuality}
    localSpeaking={call.localSpeaking} remoteSpeaking={call.remoteSpeaking} noiseFilterEnabled={call.noiseFilterEnabled}
    noiseFilterKind={call.noiseFilterKind} remoteAudioRef={call.remoteAudioRef}
    onAccept={call.acceptCall} onReject={call.rejectCall} onEnd={call.endCall} onToggleMute={call.toggleMute}
    onToggleDeafen={call.toggleDeafen} onToggleNoiseFilter={call.toggleNoiseFilter} onToggleCamera={call.toggleCamera}
    onSelectCamera={call.selectCamera} cameraDeviceId={call.cameraDeviceId} onFlipCamera={call.flipCamera}
    canFlipCamera={call.canFlipCamera} onToggleScreenShare={call.toggleScreenShare}
    onToggleMinimized={() => call.setMinimized(value => !value)} />;
});

export const ConnectedVoiceOverlay = memo(function ConnectedVoiceOverlay(props: Pick<ComponentProps<typeof VoiceOverlay>, "selfAvatarUrl" | "currentGroupId" | "onExpand">) {
  const voice = useRuntimeState("voice", state => state);
  return <VoiceOverlay {...props} active={voice.active} peers={voice.peers} selfName={voice.selfName}
    localStream={voice.localStream} remoteStreams={voice.remoteStreams} muted={voice.muted} deafened={voice.deafened}
    cameraOff={voice.cameraOff} sharingScreen={voice.sharingScreen} mediaBusy={voice.mediaBusy}
    minimized={voice.minimized} selfSpeaking={voice.selfSpeaking} noiseFilterEnabled={voice.noiseFilterEnabled}
    noiseFilterKind={voice.noiseFilterKind} connectionLabel={voice.connectionLabel} connectionQuality={voice.connectionQuality}
    rttMs={voice.rttMs} onLeave={voice.leave} onToggleMute={voice.toggleMute} onToggleDeafen={voice.toggleDeafen}
    onToggleNoiseFilter={voice.toggleNoiseFilter} onToggleCamera={voice.toggleCamera} onSelectCamera={voice.selectCamera}
    cameraDeviceId={voice.cameraDeviceId} onFlipCamera={voice.flipCamera} canFlipCamera={voice.canFlipCamera}
    onToggleScreenShare={voice.toggleScreenShare} onToggleMinimized={() => voice.setMinimized(value => !value)} />;
});

export const ConnectedVoiceDock = memo(function ConnectedVoiceDock(props: Pick<ComponentProps<typeof VoiceDock>, "onExpand">) {
  const voice = useRuntimeState("voice", state => ({ title: state.active?.title ?? "", connectionLabel: state.connectionLabel,
    connectionQuality: state.connectionQuality, rttMs: state.rttMs, muted: state.muted, deafened: state.deafened,
    onToggleMute: state.toggleMute, onToggleDeafen: state.toggleDeafen, onLeave: state.leave }));
  return <VoiceDock {...props} {...voice} />;
});

export const DirectCallChip = memo(function DirectCallChip(props: Pick<ComponentProps<typeof HeaderCallChip>, "avatarUrl" | "onOpen">) {
  const call = useRuntimeState("call", state => ({ title: state.active?.peerName ?? "", muted: state.muted,
    speaking: state.localSpeaking || state.remoteSpeaking, onToggleMute: state.toggleMute, onEnd: state.endCall,
    subtitle: `${state.status === "На линии" ? state.durationLabel : !state.status || /^Соединение/.test(state.status) ? "Подключение…" : state.status}${state.sharingScreen || state.remoteSharingScreen ? " · экран" : ""}` }));
  return <HeaderCallChip {...props} {...call} mark="call" />;
});

export const GroupCallChip = memo(function GroupCallChip(props: Pick<ComponentProps<typeof HeaderCallChip>, "onOpen">) {
  const voice = useRuntimeState("voice", state => ({ title: state.active?.title ?? "", muted: state.muted,
    speaking: Boolean(state.selfSpeaking || state.peers.some(peer => peer.speaking)),
    onToggleMute: state.toggleMute, onEnd: state.leave,
    subtitle: state.connectionLabel || `${state.peers.length === 0 ? "только вы" : `${state.peers.length + 1} в канале`}${state.sharingScreen || state.peers.some(peer => peer.sharingScreen) ? " · экран" : ""}` }));
  return <HeaderCallChip {...props} {...voice} mark="voice" />;
});

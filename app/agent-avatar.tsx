// An agent's avatar (lib/agent/avatar.ts): a small mirrored pattern from its name in its
// harness's brand colour, drawn as SVG cells on a faint tint of the same colour. In the agent
// tile's header and the Agents panel.

import { agentAvatar, AVATAR_CELLS } from "../lib/agent/avatar.ts";

export function AgentAvatar(
  props: { name: string; harness?: string; size?: number },
) {
  const a = agentAvatar(props.name, props.harness);
  const size = props.size ?? 16;
  return (
    <svg
      class="agent-avatar"
      data-testid="agent-avatar"
      data-harness={props.harness ?? "claude"}
      data-color={a.color}
      width={size}
      height={size}
      viewBox={`-0.5 -0.5 ${AVATAR_CELLS + 1} ${AVATAR_CELLS + 1}`}
      aria-hidden="true"
    >
      <rect
        x="-0.5"
        y="-0.5"
        width={AVATAR_CELLS + 1}
        height={AVATAR_CELLS + 1}
        rx="1.2"
        fill={a.color}
        fill-opacity="0.18"
      />
      {a.cells.map((on, i) =>
        on
          ? (
            <rect
              key={i}
              x={i % AVATAR_CELLS}
              y={Math.floor(i / AVATAR_CELLS)}
              width="1"
              height="1"
              fill={a.color}
              fill-opacity={a.shade}
            />
          )
          : null
      )}
    </svg>
  );
}

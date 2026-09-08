import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../../threadRoutes";
import { relatedChats } from "@t3tools/client-runtime/state/sideChat";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MessagesSquare } from "lucide-react";
import { memo, useMemo } from "react";
import { useThreadShells, useThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";

export const RelatedChatsMenu = memo(function RelatedChatsMenu({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell({ environmentId, threadId });
  const onOpen = (id: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: id }),
    });
  };
  const threads = useThreadShells();
  const chats = useMemo(() => (thread ? relatedChats(thread, threads) : []), [thread, threads]);
  if (chats.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border/60 px-3 py-1">
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="sm" />}>
          <MessagesSquare className="size-4" /> Related chats
        </MenuTrigger>
        <MenuPopup align="start" className="w-72 max-w-[calc(100vw-2rem)]">
          {chats.map(({ thread: item, relation }) => (
            <MenuItem key={item.id} onClick={() => onOpen(item.id)}>
              <span className="min-w-0">
                <span className="block text-xs text-muted-foreground">{relation}</span>
                <span className="block truncate">{item.title}</span>
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
});

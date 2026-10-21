'use client';

import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import type { DropEdge } from '@/lib/profileSections';
import type { GripProps } from './SectionCard';
import css from './profileEditor.module.css';

/**
 * The draggable wrapper round one section card - native HTML5 drag and drop,
 * because the cards are large, few, and move within one column, which is
 * exactly what the browser's own drag does well.
 *
 * `draggable` is set only while the card's grip is pressed (`armed`): a
 * draggable ancestor breaks selecting text with the mouse inside its inputs
 * in Firefox, and a card is mostly inputs. The arm is released on pointer up
 * anywhere, on pointer cancel (which a drag that starts fires) and when the
 * drag ends. `dataTransfer.setData` is called because Firefox starts no drag
 * without data; what the data says is beside the point - the editor knows
 * what is being dragged from `onDragStart`.
 *
 * Where a drop would land is decided by the pointer's half of the slot it is
 * over, before or after, and drawn by the slot as a line on that edge
 * (`data-drop`); the dragged card itself is dimmed (`data-dragging`). The
 * editor keeps the one drag state, so a slot asks rather than decides.
 */
export function SectionSlot({
  sectionRef,
  dragActive,
  dragging,
  dropEdge,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}: {
  sectionRef: string;
  /** Whether a drag is in progress anywhere in the column, so a slot accepts drag-over only then. */
  dragActive: boolean;
  /** Whether this card is the one being dragged. */
  dragging: boolean;
  /** The edge a drop here would land on, when the pointer is over this slot. */
  dropEdge: DropEdge | null;
  onDragStart: (sectionRef: string) => void;
  onDragOver: (sectionRef: string, edge: DropEdge) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  children: (grip: GripProps) => ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  // Released wherever the pointer comes up: a press on the grip that never
  // moved must not leave the card draggable, with its inputs unselectable.
  useEffect(() => {
    if (!armed) return;
    const release = () => setArmed(false);
    window.addEventListener('pointerup', release);
    return () => window.removeEventListener('pointerup', release);
  }, [armed]);

  const grip: GripProps = {
    onPointerDown: () => setArmed(true),
    onPointerUp: () => setArmed(false),
    onPointerCancel: () => setArmed(false),
  };

  const start = (event: DragEvent<HTMLDivElement>) => {
    if (!armed) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData('text/plain', sectionRef);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(sectionRef);
  };

  const over = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    onDragOver(sectionRef, event.clientY < box.top + box.height / 2 ? 'before' : 'after');
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return;
    event.preventDefault();
    setArmed(false);
    onDrop();
  };

  return (
    <div
      className={css.slot}
      draggable={armed}
      data-dragging={dragging ? 'true' : undefined}
      data-drop={dropEdge ?? undefined}
      onDragStart={start}
      onDragOver={over}
      onDrop={drop}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
    >
      {children(grip)}
    </div>
  );
}

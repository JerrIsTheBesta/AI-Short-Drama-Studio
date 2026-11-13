<script setup lang="ts">
import { requestNodeLinkMenu } from '@/services/canvas/canvasBridge'

const props = defineProps<{ nodeId: string }>()

function open(ev: MouseEvent, side: 'prev' | 'next') {
  requestNodeLinkMenu(props.nodeId, ev.clientX, ev.clientY, side)
}
</script>

<template>
  <button
    type="button"
    class="plus plus-in node-plus nodrag nopan nowheel"
    title="在前面添加节点"
    @pointerdown.stop
    @mousedown.prevent.stop="open($event, 'prev')"
  >
    <span class="mark" aria-hidden="true"></span>
  </button>
  <button
    type="button"
    class="plus plus-out node-plus nodrag nopan nowheel"
    title="在后面添加节点"
    @pointerdown.stop
    @mousedown.prevent.stop="open($event, 'next')"
  >
    <span class="mark" aria-hidden="true"></span>
  </button>
</template>

<style scoped>
.plus {
  position: absolute;
  z-index: 6;
  display: grid;
  width: 22px;
  height: 22px;
  margin: 0;
  padding: 0;
  place-items: center;
  top: var(--link-y, 50%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  background: #5c5a64;
  color: rgba(255, 255, 255, 0.92);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease;
}
.plus-in {
  left: -36px;
  transform: translateY(-50%) translateX(8px);
}
.plus-out {
  right: -36px;
  transform: translateY(-50%) translateX(-8px);
}
.plus:hover {
  background: #6e6c76;
  border-color: rgba(255, 255, 255, 0.28);
}
.mark {
  position: relative;
  width: 10px;
  height: 10px;
}
.mark::before,
.mark::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  background: currentColor;
  border-radius: 1px;
  transform: translate(-50%, -50%);
}
.mark::before {
  width: 10px;
  height: 2px;
}
.mark::after {
  width: 2px;
  height: 10px;
}
</style>

<style>
.fnode,
.pnode {
  --link-y: calc(50% - 16px);
}
.fnode.kind-audio {
  --link-y: calc(50% - 18px);
}
.fnode > .vue-flow__handle,
.pnode > .vue-flow__handle {
  top: var(--link-y, 50%);
}
.vue-flow__node:hover .node-plus,
.vue-flow__node.selected .node-plus {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(-50%);
}
</style>

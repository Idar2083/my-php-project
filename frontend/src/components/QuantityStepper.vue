<script setup>
defineProps({ quantity: Number, name: String, disabled: Boolean, max: { type: Number, default: 30 } })
defineEmits(['adjust'])
</script>

<template>
  <div class="stepper" role="group" :aria-label="`Количество: ${name}`">
    <button type="button" class="secondary" :disabled="disabled || quantity <= 1"
      :aria-label="`Уменьшить количество: ${name}`" @click="$emit('adjust', -1)">−</button>
    <output>{{ quantity }}</output>
    <button type="button" class="secondary" :disabled="disabled || quantity >= max"
      :aria-label="`Увеличить количество: ${name}`" @click="$emit('adjust', 1)">+</button>
  </div>
</template>

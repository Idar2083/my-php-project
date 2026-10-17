<script setup>
defineProps({ error: { type: Object, default: null } })
</script>
<template>
  <div v-if="error" class="notice error" role="alert">
    <p>{{ error.message }}</p>
    <ul v-if="error.errors?.length"><li v-for="(message, index) in error.errors" :key="index">{{ message }}</li></ul>
  </div>
</template>

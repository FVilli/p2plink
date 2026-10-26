/** MQTT topic-filter matching (`+` single level, `#` trailing multi-level). */
export function mqttTopicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let i = 0; i < filterParts.length; i += 1) {
    const part = filterParts[i];
    if (part === "#") return i === filterParts.length - 1;
    if (i >= topicParts.length) return false;
    if (part !== "+" && part !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

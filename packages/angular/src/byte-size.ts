import {
  ChangeDetectionStrategy,
  Component,
  Pipe,
  computed,
  input,
  type PipeTransform,
} from "@angular/core";

export type ByteSizeInput = number | null | undefined;

/**
 * Human-readable byte size: bytes, KB or MB with one decimal.
 * The unit is chosen from the value, not from the counter type.
 */
export function formatBytes(value: ByteSizeInput): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1024) return `${Math.round(value)} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Standalone Angular component for displaying a byte counter.
 *
 * ```html
 * <p2p-byte-size [bytes]="peer.p2pBytes" />
 * ```
 */
@Component({
  selector: "p2p-byte-size",
  standalone: true,
  template: `<span class="p2p-byte-size">{{ formatted() }}</span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ByteSizeComponent {
  readonly bytes = input<ByteSizeInput>(null);
  readonly formatted = computed(() => formatBytes(this.bytes()));
}

/** Standalone pipe variant, useful inside existing Angular tables. */
@Pipe({
  name: "p2pByteSize",
  standalone: true,
  pure: true,
})
export class ByteSizePipe implements PipeTransform {
  transform(value: ByteSizeInput): string {
    return formatBytes(value);
  }
}

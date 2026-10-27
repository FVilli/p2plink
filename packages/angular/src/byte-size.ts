import {
  ChangeDetectionStrategy,
  Component,
  Pipe,
  computed,
  input,
  type PipeTransform,
} from "@angular/core";
import { formatByteSize } from "@p2plink/core";

export type ByteSizeInput = number | null | undefined;

/** Backwards-compatible name used by the component and pipe. */
export const formatBytes = formatByteSize;

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

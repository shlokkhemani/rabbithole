# PDF integration fixture

`attention-is-all-you-need.pdf` is arXiv v7 of *Attention Is All You Need*
([arXiv:1706.03762](https://arxiv.org/abs/1706.03762)), downloaded from the
canonical arXiv PDF endpoint. It is the real-world fixture for PDF ingestion,
rendering, text selection, region selection, local zoom, crops, conversion, and
offline snapshot tests.

- SHA-256: `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`
- Pages: 15
- Visible page box: 612 × 792 points

`attention-is-all-you-need-pages-1-2.pdf` is a vector/text-preserving
Ghostscript extraction of the first two pages for conversion state-machine
tests that deliberately run the same source repeatedly. It avoids rasterizing
or inventing a toy document while keeping those tests fast.

- SHA-256: `65cae01c322409df246edb88e6dba67b6dda7ab37abf2ff4c4ed0baa95d7a0ed`
- Pages: 2

Tiny generated PDFs remain only where a test deliberately needs blank/scanned,
malformed, encrypted, oversized, rotated, or unusual `CropBox`/`UserUnit`
input that this paper does not contain.

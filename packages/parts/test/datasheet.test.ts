import { describe, expect, it } from 'vitest';
import { describeDatasheetPages, findDesignSections, pageList } from '../src/index.ts';

describe('design sections of a datasheet', () => {
  it('finds the typical application, design procedure and layout by their headings', () => {
    const pages = [
      // contents: every heading with dot leaders, not the sections themselves
      'Table of Contents\n8.2 Typical Application . . . . . . . . . . 2\n10.1 Layout Guidelines ........................ 3',
      '8 | Application and Implementation\n8.2 Typical Application\nFigure 20. 12-V to 3.3-V Converter\n8.2.2 Detailed Design Procedure\n8.2.2.3 Output Inductor Selection (LO)',
      'APPLICATION INFORMATION (continued)\nTypical Applications',
      '10.1 Layout Guidelines\nLayout is a critical portion of good power supply design.\nthe layout\nPCB Layout',
    ];
    expect(findDesignSections(pages).map((h) => `${h.page} ${h.section} ${h.heading}`)).toEqual([
      '2 application Application and Implementation',
      '2 application Typical Application',
      '2 design Detailed Design Procedure',
      '2 design Output Inductor Selection (LO)',
      '3 application APPLICATION INFORMATION (continued)',
      '3 application Typical Applications',
      '4 layout Layout Guidelines',
      '4 layout PCB Layout',
    ]);
  });

  it('writes page lists short', () => {
    expect(pageList([26, 24, 25, 30, 25])).toBe('24–26, 30');
    expect(describeDatasheetPages({ pinout: [4], application: [24, 25], layout: [39] })).toBe('pinout p.4, typical application p.24–25, layout guidelines p.39');
  });
});

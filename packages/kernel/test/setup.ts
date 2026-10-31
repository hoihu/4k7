/** `npm run test:derived`: every remembered result is worked out again and compared (derive.ts). */
import { checkDerived } from '../src/derive.ts';

if (process.env.CHECK_DERIVED) checkDerived(true);

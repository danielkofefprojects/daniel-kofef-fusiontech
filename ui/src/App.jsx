import { useEffect, useState } from 'react';
import SubmitPage from './SubmitPage.jsx';
import FeedbackPage from './FeedbackPage.jsx';

// Minimal hash router: "#/" = submit page, "#/feedback" = list page.
export default function App() {
  const [route, setRoute] = useState(location.hash || '#/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const onList = route.startsWith('#/feedback');
  return (
    <>
      <nav>
        <strong>Feedback Insights</strong>
        <a href="#/" className={onList ? '' : 'active'}>Submit</a>
        <a href="#/feedback" className={onList ? 'active' : ''}>Feedback</a>
      </nav>
      <main>{onList ? <FeedbackPage /> : <SubmitPage />}</main>
    </>
  );
}

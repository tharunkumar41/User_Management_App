import { Component } from 'react';

// Without this, any render error unmounts the whole app and leaves a blank white page.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot" style={{ flexDirection: 'column', gap: '.75rem', textAlign: 'center', padding: '1rem' }}>
        <h1>Something went wrong</h1>
        <p className="muted" style={{ margin: 0 }}>Reload the page to continue. If it keeps happening, check the browser console for details.</p>
        <button className="btn btn-primary" onClick={() => { window.location.href = '/'; }}>Reload</button>
      </div>
    );
  }
}

import React from 'react';
import { BrowserRouter as Router, Route, Switch } from 'react-router-dom';
import Login from './pages/Login';
import ChittyPlans from './pages/ChittyPlans';
import NotFound from './pages/NotFound'; // Custom 404 page

const App = () => {
  return (
    <Router>
      <Switch>
        <Route exact path="/login" component={Login} />
        <Route exact path="/chitty-plans" component={ChittyPlans} />
        <Route component={NotFound} /> {/* Custom 404 page */}
      </Switch>
    </Router>
  );
};

export default App;

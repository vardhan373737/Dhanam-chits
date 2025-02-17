import React, { useEffect } from 'react';

const Login = () => {
  useEffect(() => {
    console.log('Login component mounted');
    // Add more logging as needed
  }, []);

  return (
    <div>
      <h1>Login Page</h1>
      {/* ...existing code... */}
    </div>
  );
};

export default Login;
